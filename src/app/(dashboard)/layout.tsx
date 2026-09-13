import DashboardShell from "@/components/DashboardShell";
import { ownerStore } from "@/lib/owner";

// Rendered per request: ownerStore() reads the session and redirects to /login when the
// owner is not signed in. Pages and actions still call the owner helpers themselves.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { email } = await ownerStore();
  return <DashboardShell ownerEmail={email}>{children}</DashboardShell>;
}
