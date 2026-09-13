import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

export default function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <Stack
      direction="row"
      sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", columnGap: 2, rowGap: 1.5, mb: 3 }}
    >
      <Typography variant="h5" component="h1" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {title}
      </Typography>
      {action}
    </Stack>
  );
}
