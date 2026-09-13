import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import LinkButton from "@/components/LinkButton";
import PageHeader from "@/components/PageHeader";
import BranchList from "@/components/videos/BranchList";
import DeleteVideoCard from "@/components/videos/DeleteVideoCard";
import MonitoringSwitch from "@/components/videos/MonitoringSwitch";
import VideoEditor from "@/components/videos/VideoEditor";
import { ownerStore } from "@/lib/owner";
import { VIDEOS_PATH } from "@/lib/paths";
import { getVideoOrNotFound } from "@/lib/videos/load";
import { toBranchRows } from "@/lib/videos/view";

export default async function VideoPage({ params }: PageProps<"/videos/[videoId]">) {
  // The owner check comes first, so a signed out visitor learns nothing about which ids exist.
  const { store } = await ownerStore();
  const { videoId } = await params;
  const video = await getVideoOrNotFound(store, videoId);
  const [branchItems, deleteBlocked] = await Promise.all([
    store.listBranchesForVideo(video.id),
    store.hasSendingOrSentReply(video.id),
  ]);
  const branches = toBranchRows(branchItems, new Date());

  return (
    <Box sx={{ maxWidth: 960 }}>
      <LinkButton href={VIDEOS_PATH} size="small" startIcon={<ArrowBackIcon />} sx={{ mb: 1, ml: -0.5 }}>
        Videos
      </LinkButton>
      <PageHeader title={video.title} />
      <Stack spacing={3}>
        <MonitoringSwitch videoId={video.id} monitoring={video.monitoring} />
        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <VideoEditor key={video.id} video={{ id: video.id, title: video.title, script: video.script }} />
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
              Branches
            </Typography>
            <BranchList branches={branches} />
          </CardContent>
        </Card>
        <DeleteVideoCard videoId={video.id} blocked={deleteBlocked} />
      </Stack>
    </Box>
  );
}
