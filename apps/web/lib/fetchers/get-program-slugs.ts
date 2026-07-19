import { prisma } from "@/lib/prisma";
import { cache } from "react";

export const getProgramSlugs = cache(async () => {
  try {
    return await prisma.program.findMany({
      select: {
        slug: true,
      },
      orderBy: {
        applications: {
          _count: "desc",
        },
      },
      take: 250,
    });
  } catch (error) {
    // During a build with no database reachable (e.g. the Docker image build),
    // return no slugs so these pages render on-demand at runtime instead of
    // being pre-rendered. At runtime the DB is available and pages are rendered
    // lazily (dynamicParams), so no coverage is lost.
    console.warn(
      "getProgramSlugs: database unavailable, skipping static params",
      error,
    );
    return [] as { slug: string }[];
  }
});
