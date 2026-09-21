import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ENDPOINT = `${SUPABASE_URL}/functions/v1/ecommerce-whatsapp-api`;

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-muted text-foreground text-sm rounded-md p-4 overflow-x-auto">
      <code>{children}</code>
    </pre>
  );
}

export default function EcommerceWhatsAppApi() {
  return (
    <div className="container max-w-4xl mx-auto py-10 space-y-8">
      <header className="space-y-2">
        <Badge variant="secondary">E-commerce API</Badge>
        <h1 className="text-3xl font-bold">WhatsApp for E-commerce</h1>
        <p className="text-muted-foreground">
          Send order confirmations, invoices, shipping updates and abandoned-cart
          follow-ups to your customers through your Postora WhatsApp account.
          Designed for Shopify, WooCommerce, custom stores (e.g. Curemedkw) and
          any backend that can make an HTTPS request.
        </p>
      </header>

      <Card>
        <CardHeader><CardTitle>Endpoint</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Code>{`POST ${ENDPOINT}`}</Code>
          <p className="text-sm text-muted-foreground">
            Authentication: send your Postora API key in the{" "}
            <code className="bg-muted px-1 rounded">x-api-key</code> header.
            Find it under <strong>Settings → API Keys</strong>.
          </p>
          <p className="text-sm text-muted-foreground">
            Rate limit: <strong>60 requests / minute</strong> per API key.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>1. Send a high-level event (recommended)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Postora maps the event to the correct pre-approved WhatsApp template.
            Supported events: <code>order.created</code>, <code>order.paid</code>,{" "}
            <code>order.shipped</code>, <code>order.delivered</code>,{" "}
            <code>cart.abandoned</code>, <code>review.request</code>.
          </p>
          <Code>{`curl -X POST ${ENDPOINT} \\
  -H "x-api-key: YOUR_POSTORA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "event",
    "event": "order.paid",
    "to": "+96599999999",
    "data": {
      "customer_name": "Ali",
      "order_number": "1042",
      "total": "12.500 KWD",
      "invoice_url": "https://store.example.com/invoices/1042.pdf"
    }
  }'`}</Code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>2. Send a specific approved template</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Code>{`{
  "action": "send_template",
  "to": "+96599999999",
  "template_name": "order_shipped_v1",
  "template_language": "en_US",
  "body_params": ["Ali", "1042", "https://track.example.com/1042"],
  "header_media": {
    "type": "image",
    "link": "https://store.example.com/img/shipped.jpg"
  }
}`}</Code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>3. Send free text (24h customer-service window only)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            WhatsApp only allows free text within 24h after the customer messages you.
            Outside that window, use a template.
          </p>
          <Code>{`{
  "action": "send_text",
  "to": "+96599999999",
  "text": "Thanks! Your order is being prepared."
}`}</Code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>4. Send media / PDF invoice</CardTitle></CardHeader>
        <CardContent>
          <Code>{`{
  "action": "send_media",
  "to": "+96599999999",
  "media_type": "document",
  "media_url": "https://store.example.com/invoices/1042.pdf",
  "filename": "invoice-1042.pdf",
  "caption": "Your invoice for order #1042"
}`}</Code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Required WhatsApp templates</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Create and submit these templates once in Meta Business Manager →
            WhatsApp Manager → Message Templates. Postora calls them by name.
          </p>
          <ul className="text-sm space-y-1 list-disc ps-5">
            <li><code>order_confirmation_v1</code> — name, order #, total, items</li>
            <li><code>order_invoice_v1</code> — name, order #, total (header: PDF)</li>
            <li><code>order_shipped_v1</code> — name, order #, tracking URL</li>
            <li><code>order_delivered_v1</code> — name, order #</li>
            <li><code>abandoned_cart_v1</code> — name, cart URL</li>
            <li><code>review_request_v1</code> — name, product, review URL</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Response</CardTitle></CardHeader>
        <CardContent>
          <Code>{`{
  "success": true,
  "wa_message_id": "wamid.HBgL...",
  "conversation_id": "wa_<phone_number_id>_<customer_phone>"
}`}</Code>
        </CardContent>
      </Card>
    </div>
  );
}