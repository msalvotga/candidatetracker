function isSafeIdent(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name ?? ""));
}

export function quoteIdent(name) {
  if (!isSafeIdent(name)) throw new Error(`Unexpected database name: ${name}`);
  return `"${name}"`;
}

export function sqlTextLiteral(value) {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertCastType(type) {
  const text = String(type ?? "");
  if (!/^[A-Za-z0-9_ ,"()[\]]+$/.test(text)) throw new Error(`Unexpected column type: ${type}`);
  return text;
}

/** Parents first, so a restore can insert without tripping foreign keys. */
export function orderTablesForInsert(tableNames, foreignKeys) {
  const names = [...tableNames];
  const incoming = new Map(names.map((name) => [name, 0]));
  const childrenOf = new Map(names.map((name) => [name, []]));
  for (const edge of foreignKeys ?? []) {
    const parent = edge.parent;
    const child = edge.child;
    if (parent === child || !incoming.has(parent) || !incoming.has(child)) continue;
    incoming.set(child, (incoming.get(child) ?? 0) + 1);
    childrenOf.get(parent)?.push(child);
  }
  const ready = names.filter((name) => incoming.get(name) === 0);
  const ordered = [];
  while (ready.length) {
    const name = ready.shift();
    if (!name) break;
    ordered.push(name);
    for (const child of childrenOf.get(name) ?? []) {
      const left = (incoming.get(child) ?? 1) - 1;
      incoming.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  for (const name of names) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

async function writeChunk(output, chunk) {
  if (output.write(chunk)) return;
  await new Promise((resolve) => output.once("drain", resolve));
}

async function writeTable(client, name, output) {
  const columns = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attgenerated = ''
     ORDER BY a.attnum`,
    [name],
  );
  const cols = columns.rows.filter((column) => isSafeIdent(column.name));
  if (!cols.length) return;
  const selectList = cols.map((column) => `${quoteIdent(column.name)}::text AS ${quoteIdent(column.name)}`).join(", ");
  await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR SELECT ${selectList} FROM public.${quoteIdent(name)}`);
  const columnList = cols.map((column) => quoteIdent(column.name)).join(", ");
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const values = pending
      .map(
        (row) =>
          `(${cols
            .map((column) => {
              const text = row[column.name];
              if (text == null) return "NULL";
              return `${sqlTextLiteral(text)}::${assertCastType(column.type)}`;
            })
            .join(", ")})`,
      )
      .join(",\n");
    await writeChunk(output, `INSERT INTO public.${quoteIdent(name)} (${columnList}) VALUES\n${values};\n`);
    pending = [];
  };
  for (;;) {
    const batch = await client.query("FETCH 200 FROM export_cursor");
    if (!batch.rows.length) break;
    for (const row of batch.rows) {
      pending.push(row);
      if (pending.length >= 50) await flush();
    }
  }
  await flush();
  await client.query("CLOSE export_cursor");
}

/** Stream a restorable SQL script of every public table. */
export async function streamDatabaseSql(pool, output) {
  const client = await pool.connect();
  try {
    const tables = await client.query(
      `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`,
    );
    const foreignKeys = await client.query(
      `SELECT child.relname AS child, parent.relname AS parent
       FROM pg_constraint c
       JOIN pg_class child ON child.oid = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'`,
    );
    const names = tables.rows.map((row) => row.name).filter(isSafeIdent);
    const ordered = orderTablesForInsert(names, foreignKeys.rows);
    await writeChunk(output, `-- Election night tracker database export\n-- ${new Date().toISOString()}\nBEGIN;\n`);
    if (ordered.length) {
      await writeChunk(
        output,
        `TRUNCATE ${ordered.map((name) => `public.${quoteIdent(name)}`).join(", ")} RESTART IDENTITY CASCADE;\n`,
      );
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const name of ordered) {
      await writeTable(client, name, output);
    }
    await client.query("COMMIT");
    await writeChunk(output, "COMMIT;\n");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the read transaction may not have started */
    }
    throw error;
  } finally {
    client.release();
  }
}
