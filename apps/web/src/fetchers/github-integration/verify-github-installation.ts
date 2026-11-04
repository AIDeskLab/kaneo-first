import { client } from "@kaneo/libs";
import type { InferRequestType, InferResponseType } from "hono";
import { HttpError } from "@/lib/http-error";

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
    throw await HttpError.fromResponse(response);
  }

  const result = await response.json();

  return result;
}

export default verifyGithubInstallation;
