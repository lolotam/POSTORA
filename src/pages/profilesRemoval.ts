// Which removal flow a platform's account uses: WhatsApp accounts carry an AI agent
// setup, so they go through the delete dialog that shows what will be removed, while
// every other platform disconnects directly.
export function routeAccountRemoval(platform: string): "whatsapp-dialog" | "direct" {
  return platform === "whatsapp" ? "whatsapp-dialog" : "direct";
}
