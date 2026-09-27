// SDK errors can contain signed URLs or process output. Persist only known diagnoses.
export function cleanupError(
  stage: "stop" | "backup" | "destroy",
  error: unknown,
) {
  const message = error instanceof Error ? error.message : "";
  if (stage === "backup") {
    if (/failed to connect|connection timed out/i.test(message))
      return "Could not connect to R2. Check sandbox HTTPS egress and the R2 endpoint.";
    if (/403|AccessDenied|SignatureDoesNotMatch/i.test(message))
      return "R2 rejected the backup request. Check backup credentials and bucket permissions.";
    if (/certificate|SSL peer|curl: \(60\)/i.test(message))
      return "R2 TLS verification failed. Check the sandbox interception CA trust.";
  }
  if (/timeout|timed out/i.test(message))
    return `${stage} timed out. Check Worker and container logs.`;
  return `${stage} failed. Check Worker and container logs.`;
}
