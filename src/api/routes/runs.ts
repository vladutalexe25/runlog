import { Router } from "express";
import { getRunWithExecutions } from "../../db/repository.js";

export const runsRouter = Router();

runsRouter.get("/runs/:id", async (req, res) => {
  const run = await getRunWithExecutions(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json(run);
});
