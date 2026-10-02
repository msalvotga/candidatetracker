export function ElectionDatasetNotice({ dataset }: { dataset: string }) {
  return (
    <main className="enr-main">
      <div className="enr-panel">
        <h2 className="enr-manualVotes__title">{dataset}</h2>
        <p>
          This election does not have {dataset.toLowerCase()} yet. Choose the 2026 General Election in the menu to open
          the {dataset.toLowerCase()} already loaded.
        </p>
      </div>
    </main>
  );
}
