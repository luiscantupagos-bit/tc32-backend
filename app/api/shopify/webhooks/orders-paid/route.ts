import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Helpers
function mustEnv(name: string, v: string | undefined) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function timingSafeEqual(a: string, b: string) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyShopifyHmac(rawBody: string, hmacHeader: string, secret: string) {
  // Shopify sends base64 HMAC SHA256 of raw body
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  return timingSafeEqual(digest, hmacHeader);
}

export async function POST(req: Request) {
  try {
    const secret = mustEnv("SHOPIFY_WEBHOOK_SECRET", WEBHOOK_SECRET);

    // 1) Get headers
    const hmac = req.headers.get("x-shopify-hmac-sha256") || "";
    const topic = req.headers.get("x-shopify-topic") || "";
    const shopDomain = req.headers.get("x-shopify-shop-domain") || "";
    const webhookId = req.headers.get("x-shopify-webhook-id") || "";

    if (!hmac) {
      return new Response(JSON.stringify({ ok: false, error: "Missing HMAC header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2) Read RAW body (important for HMAC)
    const raw = await req.text();

    // 3) Verify signature
    const okHmac = verifyShopifyHmac(raw, hmac, secret);
    if (!okHmac) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid HMAC" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4) Parse payload
    const payload = raw ? JSON.parse(raw) : {};
    const orderId = payload?.id;
    const orderName = payload?.name;
    const financialStatus = payload?.financial_status;
    const paidAt = payload?.processed_at || payload?.updated_at || null;

    console.log("[orders-paid] ✅ webhook received", {
      topic,
      shopDomain,
      webhookId,
      orderId,
      orderName,
      financialStatus,
      paidAt,
    });

    // =========================================================
    // ✅ AQUÍ VA LO SIGUIENTE:
    // - Encontrar line items con properties "_TC32 Personalización" == "Sí"
    // - Tomar _TC32_PREVIEW_FIRST o _TC32_PREVIEWS
    // - Generar PDF
    // - Subir a Shopify Files
    // - Guardar URL en metacampo de orden: tc32.custom_pdf_url
    // =========================================================

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[orders-paid] ❌ error", err?.message || err);
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
