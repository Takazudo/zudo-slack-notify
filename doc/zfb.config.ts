import { defineConfig } from "zfb/config";
import { zudoDoc } from "@takazudo/zudo-doc/config";

export default defineConfig(
  zudoDoc({
    siteName: "zudo-slack-notify",
    siteUrl: "https://zudo-slack-notify.zudolab.dev",
    githubUrl: "https://github.com/Takazudo/zudo-slack-notify",
    llmsTxt: true,
    sidebarResizer: true,
    sidebarToggle: true,
    tocToggle: true,
    imageEnlarge: true,
    dynamicPageTransition: true,
    docHistory: true,
    assetViewer: true,
    footer: {
      links: [],
      copyright: "Copyright © 2026 Takazudo. Built with zudo-doc.",
    },
    headerNav: [
      {
        label: "Overview",
        path: "/docs/overview",
        categoryMatch: "overview",
      },
      {
        label: "Getting Started",
        path: "/docs/getting-started",
        categoryMatch: "getting-started",
      },
      {
        label: "API",
        path: "/docs/api",
        categoryMatch: "api",
      },
      {
        label: "CLI",
        path: "/docs/cli",
        categoryMatch: "cli",
      },
      {
        label: "Agent Skill",
        path: "/docs/agent-skill",
        categoryMatch: "agent-skill",
      },
      {
        label: "Operations",
        path: "/docs/operations",
        categoryMatch: "operations",
      },
    ],
    headerRightItems: [
      {
        type: "component",
        component: "theme-toggle",
      },
      {
        type: "component",
        component: "search",
      },
    ],
  }),
);
