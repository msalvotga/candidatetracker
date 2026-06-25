import { useCallback, useEffect, useMemo, useState } from "react";
import { createAdminUser, deleteAdminUser, fetchAdminUsers, updateAdminUser } from "../api";
import type { AppUser, UserRole } from "../types";
import { PendingSaveBar } from "./PendingSaveBar";

type RowEdits = Record<number, Partial<AppUser> & { password?: string }>;

const ROLE_OPTIONS: { id: UserRole; label: string }[] = [
  { id: "admin", label: "Admin" },
  { id: "viewer", label: "Viewer" },
];

export function AdminUsersPanel() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<RowEdits>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [newUser, setNewUser] = useState({
    username: "",
    display_name: "",
    role: "viewer" as UserRole,
    password: "",
    active: true,
  });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setUsers(await fetchAdminUsers());
      setEdits({});
      setSaved(false);
      setSaveError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const pendingUpdates = useMemo(() => {
    return Object.entries(edits)
      .map(([id, fields]) => {
        const userId = Number(id);
        const patch: Record<string, unknown> = {};
        if (fields.display_name != null) patch.display_name = fields.display_name;
        if (fields.role != null) patch.role = fields.role;
        if (fields.active != null) patch.active = fields.active;
        if (fields.password?.trim()) patch.password = fields.password.trim();
        return Object.keys(patch).length > 0 ? { userId, patch } : null;
      })
      .filter(Boolean) as { userId: number; patch: Record<string, unknown> }[];
  }, [edits]);

  const hasPendingEdits = pendingUpdates.length > 0;

  function updateCell(userId: number, field: keyof RowEdits[number], value: unknown) {
    setEdits((prev) => {
      const row = users.find((user) => user.id === userId);
      const current = row?.[field as keyof AppUser];
      const nextRow = { ...(prev[userId] ?? {}) };
      if (value === current || (field === "password" && !value)) {
        delete nextRow[field];
      } else {
        nextRow[field] = value as never;
      }
      if (Object.keys(nextRow).length === 0) {
        const { [userId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [userId]: nextRow };
    });
    setSaved(false);
    setSaveError("");
  }

  async function handleSave() {
    if (!hasPendingEdits) return;
    setSaving(true);
    setSaveError("");
    try {
      for (const update of pendingUpdates) {
        await updateAdminUser(update.userId, update.patch);
      }
      setEdits({});
      setSaved(true);
      await loadUsers();
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save users");
    } finally {
      setSaving(false);
    }
  }

  function discardEdits() {
    setEdits({});
    setSaveError("");
    setSaved(false);
  }

  async function handleAddUser() {
    if (!newUser.username.trim() || !newUser.password.trim()) {
      setError("Username and password are required");
      return;
    }
    setAdding(true);
    setError("");
    try {
      await createAdminUser({
        username: newUser.username.trim(),
        display_name: newUser.display_name.trim() || newUser.username.trim(),
        role: newUser.role,
        password: newUser.password,
        active: newUser.active,
      });
      setNewUser({ username: "", display_name: "", role: "viewer", password: "", active: true });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setAdding(false);
    }
  }

  async function handleDeleteUser(user: AppUser) {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setDeletingId(user.id);
    setError("");
    try {
      await deleteAdminUser(user.id);
      setEdits((prev) => {
        const { [user.id]: _removed, ...rest } = prev;
        return rest;
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="admin-users-panel">
      <p className="admin-add-hint">
        Manage login accounts. Usernames are email addresses. Create accounts here; promote to admin
        for Data tab and edit access.
      </p>

      {error ? <div className="banner error">{error}</div> : null}

      <div className="admin-add-row">
        <label className="admin-add-field">
          <span className="admin-add-label">Email</span>
          <input
            className="edit-input edit-input-sm"
            type="email"
            autoComplete="off"
            value={newUser.username}
            onChange={(e) => setNewUser((prev) => ({ ...prev, username: e.target.value }))}
          />
        </label>
        <label className="admin-add-field">
          <span className="admin-add-label">Display name</span>
          <input
            className="edit-input edit-input-sm"
            type="text"
            value={newUser.display_name}
            onChange={(e) => setNewUser((prev) => ({ ...prev, display_name: e.target.value }))}
          />
        </label>
        <label className="admin-add-field">
          <span className="admin-add-label">Role</span>
          <select
            className="edit-input edit-input-sm"
            value={newUser.role}
            onChange={(e) => setNewUser((prev) => ({ ...prev, role: e.target.value as UserRole }))}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-add-field">
          <span className="admin-add-label">Password</span>
          <input
            className="edit-input edit-input-sm"
            type="password"
            autoComplete="new-password"
            value={newUser.password}
            onChange={(e) => setNewUser((prev) => ({ ...prev, password: e.target.value }))}
          />
        </label>
        <label className="filter-check-item admin-data-filter-check">
          <input
            type="checkbox"
            checked={newUser.active}
            onChange={(e) => setNewUser((prev) => ({ ...prev, active: e.target.checked }))}
          />
          <span>Active</span>
        </label>
        <button type="button" className="coh-add-button" disabled={adding} onClick={() => void handleAddUser()}>
          Add user
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading users…</p>
      ) : (
        <div className="admin-data-body">
          <p className="admin-table-meta">{users.length} user(s)</p>
          {hasPendingEdits || saved ? (
            <PendingSaveBar
              visible={hasPendingEdits}
              saving={saving}
              saved={saved}
              error={saveError}
              onSave={() => void handleSave()}
              onDiscard={discardEdits}
            />
          ) : null}
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Display name</th>
                  <th>Role</th>
                  <th>Active</th>
                  <th>New password</th>
                  <th className="admin-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const rowEdits = edits[user.id] ?? {};
                  const displayName = rowEdits.display_name ?? user.display_name;
                  const role = rowEdits.role ?? user.role;
                  const active = rowEdits.active ?? user.active;
                  const password = rowEdits.password ?? "";
                  return (
                    <tr key={user.id}>
                      <td>{user.username}</td>
                      <td className="admin-cell-editable">
                        <input
                          className={`edit-input edit-input-sm${rowEdits.display_name != null ? " edit-input-changed" : ""}`}
                          type="text"
                          value={displayName}
                          onChange={(e) => updateCell(user.id, "display_name", e.target.value)}
                        />
                      </td>
                      <td className="admin-cell-editable">
                        <select
                          className={`edit-input edit-input-sm${rowEdits.role != null ? " edit-input-changed" : ""}`}
                          value={role}
                          onChange={(e) => updateCell(user.id, "role", e.target.value as UserRole)}
                        >
                          {ROLE_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="admin-cell-editable">
                        <select
                          className={`edit-input edit-input-sm${rowEdits.active != null ? " edit-input-changed" : ""}`}
                          value={active ? "1" : "0"}
                          onChange={(e) => updateCell(user.id, "active", e.target.value === "1")}
                        >
                          <option value="1">Yes</option>
                          <option value="0">No</option>
                        </select>
                      </td>
                      <td className="admin-cell-editable">
                        <input
                          className={`edit-input edit-input-sm${password ? " edit-input-changed" : ""}`}
                          type="password"
                          autoComplete="new-password"
                          placeholder="Leave blank to keep"
                          value={password}
                          onChange={(e) => updateCell(user.id, "password", e.target.value)}
                        />
                      </td>
                      <td className="admin-actions-col">
                        <button
                          type="button"
                          className="admin-row-delete"
                          disabled={deletingId === user.id}
                          onClick={() => void handleDeleteUser(user)}
                        >
                          {deletingId === user.id ? "Deleting…" : "Delete"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
