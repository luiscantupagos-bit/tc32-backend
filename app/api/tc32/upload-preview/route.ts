import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ===== ENV =====
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN; // ej: tc32.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // shpat_...
const VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

function mustEnv(name: string, v: string | undefined) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function shopifyGraphQL(query: string, variables: any = {}) {
  const shop = mustEnv("SHOPIFY_SHOP_DOMAIN", SHOP);
  const token = mustEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", TOKEN);
  const ver = mustEnv("SHOPIFY_API_VERSION", VERSION);

  const url = `https://${shop}/admin/api/${ver}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  const json = JSON.parse(text);
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== 1) stagedUploadsCreate =====
async function stagedUploadCreate(filename: string, mimeType: string, sizeBytes: number) {
  const q = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphQL(q, {
    input: [
      {
        filename,
        mimeType,
        resource: "IMAGE",
        fileSize: String(sizeBytes),
        httpMethod: "POST",
      },
    ],
  });

  const out = data?.stagedUploadsCreate;
  const err = out?.userErrors?.[0];
  if (err) throw new Error(`stagedUploadsCreate: ${err.message}`);

  const t = out.stagedTargets?.[0];
  if (!t?.url || !t?.resourceUrl) throw new Error("stagedUploadsCreate: missing target");

  return t as {
    url: string;
    resourceUrl: string;
    parameters: { name: string; value: string }[];
  };
}

// ===== 2) Upload a staged target (S3) =====
async function uploadToStagedTarget(staged: { url: string; parameters: { name: string; value: string }[] }, file: Buffer) {
  const form = new FormData();
  for (const p of staged.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([file]));

  const res = await fetch(staged.url, { method: "POST", body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`staged upload failed: ${res.status} ${res.statusText} ${t}`);
  }
}

// ===== 3) fileCreate =====
async function fileCreate(resourceUrl: string, alt: string) {
  const q = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          __typename
          ... on MediaImage { id }
          ... on GenericFile { id }
        }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(q, {
    files: [
      {
        alt,
        contentType: "IMAGE",
        originalSource: resourceUrl,
      },
    ],
  });

  const out = data?.fileCreate;
  const err = out?.userErrors?.[0];
  if (err) throw new Error(`fileCreate: ${err.message}`);

  const f = out?.files?.[0];
  if (!f?.id) throw new Error("fileCreate: missing file id");

  return f.id as string;
}

// ===== 4) Poll until READY (image url exists) =====
async function waitForImageUrl(mediaId: string, tries = 10, delayMs = 900) {
  const q = `
    query node($id: ID!) {
      node(id: $id) {
        __typename
        ... on MediaImage {
          id
          status
          image { url }
          preview { image { url } }
        }
      }
    }
  `;

  for (let i = 0; i < tries; i++) {
    const data = await shopifyGraphQL(q, { id: mediaId });
    const node = data?.node;

    const url =
      node?.image?.url ||
      node?.preview?.image?.url ||
      null;

    if (url && typeof url === "string") return url;

    // Si todavía no está listo, espera y reintenta
    await sleep(delayMs);
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const dataUrl = body?.dataUrl as string;
    const filename = (body?.filename as string) || "preview.png";
    const groupId = (body?.groupId as string) || "UNGROUPED";
    const areaKey = (body?.areaKey as string) || "HERO";

    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      return NextResponse.json({ ok: false, error: "dataUrl inválido" }, { status: 400 });
    }

    // Convert dataURL -> Buffer
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return NextResponse.json({ ok: false, error: "dataUrl formato inválido" }, { status: 400 });
    }

    const mimeType = match[1];
    const b64 = match[2];
    const buf = Buffer.from(b64, "base64");

    // 1) staged target
    const staged = await stagedUploadCreate(filename, mimeType, buf.length);

    // 2) upload bytes to staged target
    await uploadToStagedTarget(staged, buf);

    // 3) create file in Shopify
    const alt = `TC32 ${groupId} ${areaKey}`;
    const mediaId = await fileCreate(staged.resourceUrl, alt);

    // 4) wait for url
    const url = await waitForImageUrl(mediaId, 12, 900);

    if (!url) {
      // YA NO lo tratamos como “error fatal”: devolvemos id y avisamos que aún no está listo.
      return NextResponse.json(
        {
          ok: false,
          error: "Archivo creado pero aún no está READY (reintenta en unos segundos)",
          extra: { id: mediaId, image: null },
        },
        { status: 202 }
      );
    }

    // Nombre “bonito” opcional (si quieres manejarlo tú)
    const key = `${groupId}__${areaKey}`;

    return NextResponse.json({
      ok: true,
      key,
      id: mediaId,
      url,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error", extra: { name: e?.name, stack: e?.stack } },
      { status: 500 }
    );
  }
}
