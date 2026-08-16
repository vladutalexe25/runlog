import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export type FlowNodeData = {
  label: string;
  nodeType: string;
  status?: "succeeded" | "failed" | "skipped" | null;
};

export type FlowNodeType = Node<FlowNodeData, "workflowNode">;

export default function FlowNode({ data, selected }: NodeProps<FlowNodeType>) {
  const classes = ["flow-node"];
  if (selected) classes.push("selected");
  if (data.status) classes.push(`status-${data.status}`);

  const isCondition = data.nodeType === "condition";

  return (
    <div className={classes.join(" ")}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-type">{data.nodeType.replace("_", " ")}</div>
      <div className="flow-node-name">{data.label}</div>

      {isCondition ? (
        <>
          <Handle type="source" position={Position.Right} id="true" style={{ top: "35%" }} />
          <Handle type="source" position={Position.Right} id="false" style={{ top: "65%" }} />
          <div style={{ position: "absolute", right: -30, top: "27%", fontSize: 9, color: "var(--success)" }}>
            true
          </div>
          <div style={{ position: "absolute", right: -32, top: "62%", fontSize: 9, color: "var(--danger)" }}>
            false
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}
