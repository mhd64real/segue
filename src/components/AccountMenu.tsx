"use client";

import * as React from "react";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import { SIGN_OUT_PATH } from "@/lib/auth/routes";

export default function AccountMenu({ email }: { email: string }) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const open = Boolean(anchor);
  const initial = email.trim().charAt(0).toUpperCase();

  return (
    <>
      <Tooltip title="Account">
        <IconButton
          aria-label="Account"
          aria-controls={open ? "account-menu" : undefined}
          aria-haspopup="menu"
          aria-expanded={open ? "true" : undefined}
          onClick={(event) => setAnchor(event.currentTarget)}
          edge="end"
          sx={{ ml: 1 }}
        >
          <Avatar sx={{ width: 32, height: 32, bgcolor: "primary.main", typography: "body1" }}>{initial}</Avatar>
        </IconButton>
      </Tooltip>
      <Menu
        id="account-menu"
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ px: 2, pt: 1, pb: 1.5, maxWidth: 280 }}>
          <Typography variant="caption" component="p" sx={{ color: "text.secondary" }}>
            Signed in as
          </Typography>
          <Typography variant="body2" noWrap title={email}>
            {email}
          </Typography>
        </Box>
        <Divider />
        <MenuItem onClick={() => formRef.current?.requestSubmit()}>
          <ListItemIcon>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Sign out</ListItemText>
        </MenuItem>
      </Menu>
      <form ref={formRef} action={SIGN_OUT_PATH} method="post" hidden />
    </>
  );
}
