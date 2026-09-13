import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import LinkButton from "@/components/LinkButton";
import { VIDEOS_PATH } from "@/lib/paths";

// Renders inside the dashboard shell when the video page calls notFound() for a malformed,
// unknown or deleted video id. It shows no data, so it needs no owner check of its own.
export default function VideoNotFound() {
  return (
    <Box sx={{ maxWidth: 960 }}>
      <LinkButton href={VIDEOS_PATH} size="small" startIcon={<ArrowBackIcon />} sx={{ mb: 1, ml: -0.5 }}>
        Videos
      </LinkButton>
      <Alert severity="info">This video does not exist.</Alert>
    </Box>
  );
}
