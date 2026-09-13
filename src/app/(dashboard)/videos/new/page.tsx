import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import LinkButton from "@/components/LinkButton";
import PageHeader from "@/components/PageHeader";
import NewVideoForm from "@/components/videos/NewVideoForm";
import { ownerStore } from "@/lib/owner";
import { VIDEOS_PATH } from "@/lib/paths";

export default async function NewVideoPage() {
  await ownerStore();

  return (
    <Box sx={{ maxWidth: 960 }}>
      <LinkButton href={VIDEOS_PATH} size="small" startIcon={<ArrowBackIcon />} sx={{ mb: 1, ml: -0.5 }}>
        Videos
      </LinkButton>
      <PageHeader title="New video" />
      <Card variant="outlined">
        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <NewVideoForm />
        </CardContent>
      </Card>
    </Box>
  );
}
