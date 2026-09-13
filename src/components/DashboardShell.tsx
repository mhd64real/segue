"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import EmailOutlinedIcon from "@mui/icons-material/EmailOutlined";
import HandshakeOutlinedIcon from "@mui/icons-material/HandshakeOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import VideoLibraryOutlinedIcon from "@mui/icons-material/VideoLibraryOutlined";
import AccountMenu from "@/components/AccountMenu";
import GuardedLink from "@/components/GuardedLink";
import NavigationGuardProvider from "@/components/NavigationGuardProvider";
import { APP_NAME } from "@/config";

const DRAWER_WIDTH = 240;

const NAV_ITEMS = [
  { href: "/videos", label: "Videos", icon: <VideoLibraryOutlinedIcon /> },
  { href: "/sponsorships", label: "Sponsorships", icon: <HandshakeOutlinedIcon /> },
  { href: "/emails", label: "Emails", icon: <EmailOutlinedIcon /> },
];

export default function DashboardShell({ children, ownerEmail }: { children: React.ReactNode; ownerEmail: string }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [notificationsAnchor, setNotificationsAnchor] = React.useState<HTMLElement | null>(null);

  const nav = (
    <>
      <Toolbar />
      <List>
        {NAV_ITEMS.map((item) => (
          <ListItemButton
            key={item.href}
            component={GuardedLink}
            href={item.href}
            selected={pathname.startsWith(item.href)}
            onClick={() => setMobileOpen(false)}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} />
          </ListItemButton>
        ))}
      </List>
    </>
  );

  return (
    <NavigationGuardProvider>
      <Box sx={{ display: "flex" }}>
        <AppBar
          position="fixed"
          color="inherit"
          elevation={0}
          sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, borderBottom: 1, borderColor: "divider" }}
        >
          <Toolbar>
            <IconButton
              edge="start"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
              sx={{ mr: 1, display: { md: "none" } }}
            >
              <MenuIcon />
            </IconButton>
            <Typography variant="h6" component="div" noWrap sx={{ flexGrow: 1 }}>
              {APP_NAME}
            </Typography>
            <Tooltip title="Notifications">
              <IconButton
                aria-label="Notifications"
                onClick={(event) => setNotificationsAnchor(event.currentTarget)}
              >
                <NotificationsNoneOutlinedIcon />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={notificationsAnchor}
              open={Boolean(notificationsAnchor)}
              onClose={() => setNotificationsAnchor(null)}
            >
              <MenuItem disabled>No notifications</MenuItem>
            </Menu>
            <AccountMenu email={ownerEmail} />
          </Toolbar>
        </AppBar>

        <Box component="nav" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
          <Drawer
            variant="temporary"
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{ display: { xs: "block", md: "none" } }}
            slotProps={{ paper: { sx: { width: DRAWER_WIDTH } } }}
          >
            {nav}
          </Drawer>
          <Drawer
            variant="permanent"
            open
            sx={{ display: { xs: "none", md: "block" } }}
            slotProps={{ paper: { sx: { width: DRAWER_WIDTH } } }}
          >
            {nav}
          </Drawer>
        </Box>

        <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: 3 }}>
          <Toolbar />
          {children}
        </Box>
      </Box>
    </NavigationGuardProvider>
  );
}
