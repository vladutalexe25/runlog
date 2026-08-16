import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../api";
import { NODE_TYPES, type NodeType } from "../types";
import FlowNode, { type FlowNodeType } from "../components/FlowNode";

const nodeTypes = { workflowNode: FlowNode };

type EditorNode = FlowNodeType & { data: FlowNodeType["data"] & { config: Record<string, unknown> } };

function genNodeId(type: string, existing: Set<string>): string {
  const base = type.replace(/_/g, "-");
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function defaultConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "http_request":
      return { url: "", method: "GET" };
    case "transform":
    case "condition":
      return { expression: "" };
    case "delay":
      return { ms: 1000 };
    case "llm":
      return { prompt: "" };
  }
}

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getWorkflow(id)
      .then((graph) => {
        setName(graph.workflow.name);
        setDescription(graph.workflow.description ?? "");
        setNodes(
          graph.nodes.map((n) => ({
            id: n.id,
            type: "workflowNode",
            position: { x: n.positionX, y: n.positionY },
            data: { label: n.name, nodeType: n.type, config: n.config },
          })),
        );
        setEdges(
          graph.edges.map((e) => ({
            id: e.id,
            source: e.sourceNodeId,
            target: e.targetNodeId,
            sourceHandle: e.branch ?? undefined,
            label: e.branch ?? undefined,
          })),
        );
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id, setNodes, setEdges]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  const existingIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  const addNode = (type: NodeType) => {
    const newId = genNodeId(type, existingIds);
    const count = nodes.length;
    setNodes((nds) => [
      ...nds,
      {
        id: newId,
        type: "workflowNode",
        position: { x: 80 + (count % 4) * 220, y: 80 + Math.floor(count / 4) * 140 },
        data: { label: newId, nodeType: type, config: defaultConfig(type) },
      },
    ]);
    setSelectedNodeId(newId);
  };

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `${connection.source}-${connection.target}-${connection.sourceHandle ?? "e"}-${Date.now()}`,
            label: connection.sourceHandle ?? undefined,
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  const updateSelectedNode = (patch: Partial<EditorNode["data"]>) => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
    );
  };

  const updateSelectedConfig = (patch: Record<string, unknown>) => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedNodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n,
      ),
    );
  };

  const renameSelectedId = (newId: string) => {
    if (!selectedNodeId || newId === selectedNodeId) return;
    if (!newId || existingIds.has(newId)) return;
    setNodes((nds) => nds.map((n) => (n.id === selectedNodeId ? { ...n, id: newId } : n)));
    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        source: e.source === selectedNodeId ? newId : e.source,
        target: e.target === selectedNodeId ? newId : e.target,
      })),
    );
    setSelectedNodeId(newId);
  };

  const deleteSelectedNode = () => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Workflow name is required.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name,
        description: description || undefined,
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.data.nodeType as NodeType,
          name: n.data.label,
          config: n.data.config,
          positionX: n.position.x,
          positionY: n.position.y,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          branch: e.sourceHandle as "true" | "false" | undefined,
        })),
      };
      const saved = isEdit ? await api.updateWorkflow(id!, input) : await api.createWorkflow(input);
      navigate(`/workflows/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page">Loading…</div>;

  return (
    <div className="editor-shell">
      <div className="editor-topbar">
        <input
          type="text"
          placeholder="Workflow name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ minWidth: 260, fontWeight: 400 }}
        />
        <div style={{ flex: 1 }} />
        {error && <span style={{ color: "var(--danger)", fontSize: 12 }}>{error}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create workflow"}
        </button>
      </div>

      <div className="editor-body">
        <div className="editor-toolbar">
          <h3>Add node</h3>
          {NODE_TYPES.map((t) => (
            <button key={t} className="node-add-btn" onClick={() => addNode(t)}>
              + {t.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="editor-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelectedNodeId(n.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {selectedNode && (
          <div className="editor-panel">
            <h3>Node</h3>

            <div className="field">
              <label>Id (used in expressions as context.&lt;id&gt;)</label>
              <input
                type="text"
                value={selectedNode.id}
                onChange={(e) => renameSelectedId(e.target.value.trim())}
              />
            </div>

            <div className="field">
              <label>Name</label>
              <input
                type="text"
                value={selectedNode.data.label}
                onChange={(e) => updateSelectedNode({ label: e.target.value })}
              />
            </div>

            <NodeConfigFields
              nodeType={selectedNode.data.nodeType as NodeType}
              config={selectedNode.data.config}
              onChange={updateSelectedConfig}
            />

            <button className="btn btn-danger" onClick={deleteSelectedNode} style={{ marginTop: 12 }}>
              Delete node
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeConfigFields({
  nodeType,
  config,
  onChange,
}: {
  nodeType: NodeType;
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  if (nodeType === "http_request") {
    return (
      <>
        <div className="field">
          <label>URL</label>
          <input
            type="text"
            value={(config.url as string) ?? ""}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://example.com/api"
          />
        </div>
        <div className="field">
          <label>Method</label>
          <select
            value={(config.method as string) ?? "GET"}
            onChange={(e) => onChange({ method: e.target.value })}
          >
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </>
    );
  }

  if (nodeType === "transform" || nodeType === "condition") {
    return (
      <div className="field">
        <label>Expression (JS, sees `input` and `context`)</label>
        <textarea
          value={(config.expression as string) ?? ""}
          onChange={(e) => onChange({ expression: e.target.value })}
          placeholder={nodeType === "condition" ? "input.score >= 0.5" : "input.value * 2"}
        />
      </div>
    );
  }

  if (nodeType === "delay") {
    return (
      <div className="field">
        <label>Delay (ms)</label>
        <input
          type="number"
          min={0}
          value={(config.ms as number) ?? 0}
          onChange={(e) => onChange({ ms: Number(e.target.value) })}
        />
      </div>
    );
  }

  return (
    <div className="field">
      <label>Prompt (LLM node — not executable until Phase 6)</label>
      <textarea
        value={(config.prompt as string) ?? ""}
        onChange={(e) => onChange({ prompt: e.target.value })}
        placeholder="Classify: {{input}}"
      />
    </div>
  );
}
