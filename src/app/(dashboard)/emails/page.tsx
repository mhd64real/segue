import Typography from "@mui/material/Typography";
import PageHeader from "@/components/PageHeader";

export default function EmailsPage() {
  return (
    <>
      <PageHeader title="Emails" />
      <Typography sx={{ color: "text.secondary" }}>No drafts yet.</Typography>
    </>
  );
}
