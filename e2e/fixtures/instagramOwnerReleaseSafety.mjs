export function assertLocalDockerSocket(endpoint) {
  if (typeof endpoint !== "string" || !(/^unix:\/\/\//.test(endpoint) || /^npipe:\/{4}\.\/pipe\//.test(endpoint))) {
    throw new Error("Owner-release fixtures require a local Docker Unix/named-pipe socket");
  }
}
