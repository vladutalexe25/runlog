import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import WorkflowListPage from "./pages/WorkflowListPage";
import WorkflowEditorPage from "./pages/WorkflowEditorPage";
import WorkflowDetailPage from "./pages/WorkflowDetailPage";

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <Link to="/" className="app-title">
            Webhook Automation Runner
          </Link>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<WorkflowListPage />} />
            <Route path="/workflows/new" element={<WorkflowEditorPage />} />
            <Route path="/workflows/:id/edit" element={<WorkflowEditorPage />} />
            <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
