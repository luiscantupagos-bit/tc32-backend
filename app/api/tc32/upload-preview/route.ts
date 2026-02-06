import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ===== ENV =====
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN; // ej: "tc32.myshopify.com"
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // Admin API access token
const VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

function mustEnv(name: string, v: string | undefined) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function shopifyGraphqlUrl(shopDomain: string) {
  return `https://${shopDomain}/admin/api/${VERSION}/graphql.json`;
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || "");
  if (!m) throw new Error("dataUrl inválido (esperaba data:*/*;base64,...)");
  const mime = m[1];
  const b64 = m[2];
  const buffer = Buffer.from(b64, "base64");
  return { mime, buffer };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function shopifyGraphql<T = any>(query: string, variables: any) {
  const shop = mustEnv("SHOPIFY_SHOP_DOMAIN", SHOP);
  const token = mustEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", TOKEN);

  const res = await fetch(shopifyGraphqlUrl(shop), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`
    );
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

export async function POST(req: Request) {
  try {
    const { dataUrl, filename, groupId, areaKey } = (await req.json()) as {
      dataUrl: string;
      filename: string;
      groupId?: string;
      areaKey?: string;
    };

    if (!dataUrl || !filename) {
      return NextResponse.json(
        { ok: false, error: "Falta dataUrl o filename" },
        { status: 400 }
      );
    }

    const { mime, buffer } = parseDataUrl(dataUrl);

    // 1) stagedUploadsCreate
    const stagedData = await shopifyGraphql<{
      stagedUploadsCreate: {
        stagedTargets: Array<{
          url: string;
          resourceUrl: string;
          parameters: Array<{ name: string; value: string }>;
        }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `
      mutation Staged($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
      `,
      {
        input: [
          {
            resource: "IMAGE",
            filename,
            mimeType: mime,
            httpMethod: "POST",
          },
        ],
      }
    );

    const errs1 = stagedData.stagedUploadsCreate.userErrors || [];
    if (errs1.length) {
      return NextResponse.json(
        { ok: false, error: "stagedUploadsCreate error", extra: errs1 },
        { status: 400 }
      );
    }

    const staged = stagedData.stagedUploadsCreate.stagedTargets?.[0];
    if (!staged?.url || !staged?.resourceUrl) {
      return NextResponse.json(
        { ok: false, error: "No recibí staged target" },
        { status: 500 }
      );
    }

    // 2) Subir el archivo al staged url (FormData + Blob)
    const form = new FormData();
    for (const p of staged.parameters) form.append(p.name, p.value);

    // ✅ FIX REAL: Buffer -> Uint8Array "normal" (ArrayBuffer) para BlobPart
    // Esto evita el error TS de ArrayBufferLike/SharedArrayBuffer
    const bytes = Uint8Array.from(buffer);

    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });

    // IMPORTANTE: pasar filename
    form.append("file", blob, filename);

    const upRes = await fetch(staged.url, { method: "POST", body: form });
    if (!upRes.ok) {
      const t = await upRes.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: "Error subiendo a staged url", extra: t },
        { status: 500 }
      );
    }

    // 3) fileCreate (Shopify Files)
    const createData = await shopifyGraphql<{
      fileCreate: {
        files: Array<{
          id: string;
          fileStatus: string;
          __typename: string;
          image?: { url?: string | null } | null; // MediaImage
          url?: string | null; // GenericFile
        }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `
      mutation FileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            __typename
            id
            fileStatus
            ... on MediaImage {
              image { url }
            }
            ... on GenericFile {
              url
            }
          }
          userErrors { field message }
        }
      }
      `,
      {
        files: [
          {
            alt: `${groupId || "TC32"}_${areaKey || "HERO"}`,
            contentType: "IMAGE",
            originalSource: staged.resourceUrl,
          },
        ],
      }
    );

    const errs2 = createData.fileCreate.userErrors || [];
    if (errs2.length) {
      return NextResponse.json(
        { ok: false, error: "fileCreate error", extra: errs2 },
        { status: 400 }
      );
    }

    const created = createData.fileCreate.files?.[0];
    if (!created?.id) {
      return NextResponse.json(
        { ok: false, error: "Archivo creado pero sin ID" },
        { status: 500 }
      );
    }

    // 4) A veces Shopify tarda en poblar image.url => polling corto
    let url: string | null =
      (created as any)?.image?.url || (created as any)?.url || null;

    if (!url) {
      for (let i = 0; i < 6; i++) {
        await sleep(800);

        const nodeData = await shopifyGraphql<{ node: any }>(
          `
          query Node($id: ID!) {
            node(id: $id) {
              __typename
              ... on MediaImage {
                image { url }
              }
              ... on GenericFile {
                url
              }
            }
          }
          `,
          { id: created.id }
        );

        const n = nodeData.node;
        url = n?.image?.url || n?.url || null;
        if (url) break;
      }
    }

    if (!url) {
      return NextResponse.json(
        {
          ok: false,
          error: "Archivo creado pero no recibí URL",
          extra: { id: created.id, image: (created as any)?.image || null },
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      key: `${groupId || "TC32"}__${areaKey || "HERO"}`,
      id: created.id,
      url,
    });
  } catch (e: any) {
    console.error("[/api/tc32/upload-preview] ERROR:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Internal error" },
      { status: 500 }
    );
  }
}
