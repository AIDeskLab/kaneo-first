import { client } from "@kaneo/libs";
import type { InferRequestType, InferResponseType } from "hono";

export type VerifyGithubInstallationRequest = InferRequestType<
  (typeof client)["github-integration"]["verify"][":projectId"]["$post"]
>["json"] & { projectId: string };

export type VerifyGithubInstallationResponse = InferResponseType<
  (typeof client)["github-integration"]["verify"][":projectId"]["$post"],
  200
>;

async function verifyGithubInstallation(
  data: VerifyGithubInstallationRequest,
): Promise<VerifyGithubInstallationResponse> {
  const { projectId, ...json } = data;
  const response = await client["github-integration"].verify[
    ":projectId"
  ].$post({ param: { projectId }, json });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Request failed");
  }

  const result = await response.json();

  return result;
}

export default verifyGithubInstallation;
