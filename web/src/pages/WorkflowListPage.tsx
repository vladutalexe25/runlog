import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Workflow } from "../types";

export default function WorkflowListPage() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listWorkflows()
      .then(setWorkflows)
      .catch((err) => setError(err.message));
  }, []);

  const handleDelete = async (e: React.MouseEvent, workflow: Workflow) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${workflow.name}"? This also deletes its run history. This can't be undone.`)) return;
    try {
      await api.deleteWorkflow(workflow.id);
      setWorkflows((wfs) => wfs?.filter((w) => w.id !== workflow.id) ?? wfs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Workflows</h1>
        <Link to="/workflows/new" className="btn btn-primary">
          + New workflow
        </Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {workflows === null && !error && <p>Loading…</p>}

      {workflows?.length === 0 && (
        <div className="card empty-state">
          No workflows yet. <Link to="/workflows/new">Create one</Link> to get started.
        </div>
      )}

      {workflows && workflows.length > 0 && (
        <div className="workflow-list">
          {workflows.map((w) => (
            <Link key={w.id} to={`/workflows/${w.id}`} className="card workflow-row">
              <div>
                <div className="workflow-row-name">{w.name}</div>
                {w.description && <div className="workflow-row-meta">{w.description}</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div className="workflow-row-meta">{new Date(w.createdAt).toLocaleString()}</div>
                <button className="btn btn-danger" onClick={(e) => handleDelete(e, w)}>
                  Delete
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
