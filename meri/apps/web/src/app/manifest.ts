import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Meri",
    short_name: "Meri",
    description: "Organiza tu trabajo, protege tu tiempo, anticipa los problemas.",
    start_url: "/hoy",
    display: "standalone",
    background_color: "#E9EEF1",
    theme_color: "#0E6B74",
    lang: "es",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
