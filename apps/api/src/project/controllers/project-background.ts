import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  assertProjectBackgroundKeyMatchesContext,
  createProjectBackgroundUploadUrl,
  deleteS3Object,
  getPrivateObject,
  isImageContentType,
  validateProjectBackgroundUploadInput,
} from "../../storage/s3";
import { normalizeApiServerUrl } from "../../utils/openapi-spec";

export async function getProjectBackground(id: string, ifNoneMatch?: string) {
  const [projectData] = await db
    .select({
      backgroundObjectKey: projectTable.backgroundObjectKey,
      backgroundMimeType: projectTable.backgroundMimeType,
      backgroundVersion: projectTable.backgroundVersion,
    })
    .from(projectTable)
    .where(eq(projectTable.id, id))
    .limit(1);

  if (!projectData?.backgroundObjectKey) {
    throw new HTTPException(404, { message: "Project background not found" });
  }

  try {
    const object = await getPrivateObject(projectData.backgroundObjectKey);
    const contentType = (
      object.contentType ||
      projectData.backgroundMimeType ||
      ""
    )
      .toLowerCase()
      .split(";")[0]
      ?.trim();

    if (!contentType || !isImageContentType(contentType)) {
      await (object.body as ReadableStream).cancel();
      throw new HTTPException(404, { message: "Project background not found" });
    }

    const etag = object.etag || `"${projectData.backgroundVersion}"`;
    const headers: Record<string, string> = {
      "Cache-Control": "private, max-age=300, must-revalidate",
      "Content-Type": contentType,
      ETag: etag,
      Vary: "Cookie, Authorization",
      "X-Content-Type-Options": "nosniff",
    };
    if (object.contentLength !== undefined) {
      headers["Content-Length"] = object.contentLength.toString();
    }
    if (object.lastModified) {
      headers["Last-Modified"] = object.lastModified.toUTCString();
    }

    if (ifNoneMatch === etag) {
      await (object.body as ReadableStream).cancel();
      return new Response(null, { status: 304, headers });
    }

    return new Response(object.body as BodyInit, { headers });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("Failed to stream project background:", error);
    throw new HTTPException(404, { message: "Project background not found" });
  }
}

function invalidUpload(error: unknown): never {
  throw new HTTPException(400, {
    message:
      error instanceof Error ? error.message : "Invalid image upload request",
  });
}

async function projectContext(id: string) {
  const [project] = await db
    .select({
      projectId: projectTable.id,
      workspaceId: projectTable.workspaceId,
    })
    .from(projectTable)
    .where(eq(projectTable.id, id))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: "Project not found" });
  return project;
}

export async function prepareProjectBackgroundUpload(
  id: string,
  contentType: string,
  size: number,
) {
  try {
    validateProjectBackgroundUploadInput(contentType, size);
  } catch (error) {
    invalidUpload(error);
  }

  const context = await projectContext(id);
  try {
    return await createProjectBackgroundUploadUrl({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      contentType,
      size,
    });
  } catch (error) {
    throw new HTTPException(503, {
      message:
        error instanceof Error
          ? error.message
          : "Image uploads are not configured",
    });
  }
}

export async function finalizeProjectBackground(input: {
  id: string;
  key: string;
  contentType: string;
  size: number;
  version: string;
  apiBaseUrl: string;
}) {
  try {
    validateProjectBackgroundUploadInput(input.contentType, input.size);
  } catch (error) {
    invalidUpload(error);
  }

  const context = await projectContext(input.id);
  const normalizedKey = input.key.trim();
  if (
    !assertProjectBackgroundKeyMatchesContext(normalizedKey, {
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      version: input.version,
    })
  ) {
    throw new HTTPException(400, {
      message: "Image upload key does not match the project context.",
    });
  }

  const [currentProject] = await db
    .select({ backgroundObjectKey: projectTable.backgroundObjectKey })
    .from(projectTable)
    .where(eq(projectTable.id, input.id))
    .limit(1);

  const [updatedProject] = await db
    .update(projectTable)
    .set({
      backgroundObjectKey: normalizedKey,
      backgroundMimeType: input.contentType,
      backgroundVersion: input.version,
    })
    .where(eq(projectTable.id, input.id))
    .returning({ id: projectTable.id });

  if (!updatedProject) {
    throw new HTTPException(500, { message: "Failed to save background" });
  }

  if (
    currentProject?.backgroundObjectKey &&
    currentProject.backgroundObjectKey !== normalizedKey
  ) {
    deleteS3Object(currentProject.backgroundObjectKey).catch((error) => {
      console.warn(`S3 cleanup error: ${error}`);
    });
  }

  await publishEvent("project.updated", { projectId: input.id });
  const apiBaseUrl = normalizeApiServerUrl(input.apiBaseUrl);
  return {
    url: `${apiBaseUrl}/project/${updatedProject.id}/background?v=${encodeURIComponent(input.version)}`,
  };
}

export async function removeProjectBackground(id: string) {
  const [currentProject] = await db
    .select({ backgroundObjectKey: projectTable.backgroundObjectKey })
    .from(projectTable)
    .where(eq(projectTable.id, id))
    .limit(1);

  const [updatedProject] = await db
    .update(projectTable)
    .set({
      backgroundObjectKey: null,
      backgroundMimeType: null,
      backgroundVersion: null,
    })
    .where(eq(projectTable.id, id))
    .returning({ id: projectTable.id });

  if (updatedProject && currentProject?.backgroundObjectKey) {
    deleteS3Object(currentProject.backgroundObjectKey).catch(() => {});
  }
  if (updatedProject) {
    await publishEvent("project.updated", { projectId: id });
  }
}
