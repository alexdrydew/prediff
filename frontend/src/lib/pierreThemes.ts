import { createThemeCollection } from "@pierre/theming";
import { normalizeTheme } from "shiki/core";

async function loadTheme(
  loader: () => Promise<{ default: unknown }>,
): Promise<ReturnType<typeof normalizeTheme>> {
  return normalizeTheme(
    (await loader()).default as Parameters<typeof normalizeTheme>[0],
  );
}

export function createTheme({
  name,
  load,
  colorScheme,
  collection,
  displayName,
}: {
  name: string;
  load: () => Promise<unknown>;
  colorScheme?: "light" | "dark";
  collection?: string;
  displayName?: string;
}) {
  return {
    name,
    colorScheme,
    collection,
    displayName,
    load: async () => {
      const loaded = await load();
      const raw =
        loaded && typeof loaded === "object" && "default" in loaded
          ? loaded.default
          : loaded;
      return normalizeTheme(raw as Parameters<typeof normalizeTheme>[0]);
    },
  };
}

// Prediff exposes one light and one dark theme. Avoid making every optional
// Pierre and Shiki theme part of the production asset graph.
export const pierreThemes = createThemeCollection({
  themes: [
    {
      name: "pierre-dark",
      colorScheme: "dark",
      collection: "pierre",
      displayName: "Pierre Dark",
      load: () => loadTheme(() => import("@pierre/theme/pierre-dark")),
    },
    {
      name: "pierre-light",
      colorScheme: "light",
      collection: "pierre",
      displayName: "Pierre Light",
      load: () => loadTheme(() => import("@pierre/theme/pierre-light")),
    },
  ],
});

export const shikiThemes = createThemeCollection({ themes: [] });
export const themes = pierreThemes;
