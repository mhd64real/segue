import LinearProgress from "@mui/material/LinearProgress";

// Shown inside the dashboard shell while a page renders on the server.
export default function DashboardLoading() {
  return <LinearProgress aria-label="Loading page" />;
}
