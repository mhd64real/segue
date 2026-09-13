import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

export default function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 3 }}>
      <Typography variant="h5" component="h1">
        {title}
      </Typography>
      {action}
    </Stack>
  );
}
