import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import VideoLibraryOutlinedIcon from "@mui/icons-material/VideoLibraryOutlined";
import LinkButton from "@/components/LinkButton";
import PageHeader from "@/components/PageHeader";
import VideosTable from "@/components/videos/VideosTable";
import { ownerStore } from "@/lib/owner";
import { NEW_VIDEO_PATH } from "@/lib/paths";
import { toVideoRows } from "@/lib/videos/view";

function NewVideoButton() {
  return (
    <LinkButton href={NEW_VIDEO_PATH} variant="contained" startIcon={<AddIcon />}>
      New video
    </LinkButton>
  );
}

export default async function VideosPage() {
  const { store } = await ownerStore();
  const rows = toVideoRows(await store.listVideos(), new Date());

  return (
    <>
      <PageHeader title="Videos" action={<NewVideoButton />} />
      {rows.length > 0 ? (
        <VideosTable rows={rows} />
      ) : (
        <Paper variant="outlined" sx={{ px: 3, py: { xs: 5, sm: 8 } }}>
          <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center" }}>
            <VideoLibraryOutlinedIcon color="action" fontSize="large" />
            <Typography variant="h6" component="h2">
              No videos yet
            </Typography>
            <Typography sx={{ color: "text.secondary", maxWidth: 440 }}>
              Add a video with its script. Monitored videos are matched against sponsorship emails.
            </Typography>
            <NewVideoButton />
          </Stack>
        </Paper>
      )}
    </>
  );
}
