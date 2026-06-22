
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { join } from "jsr:@std/path";

function resolveConfig() {
    const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL") || "https://api.postora.cloud";
    const key = (Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") || "").trim();

    if (!key) {
        console.error("Missing required env var SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY). Copy .env.example to .env and set it.");
        Deno.exit(1);
    }

    return { url, key };
}

const OUTPUT_JSON_PATH = "logo_urls.json";

async function uploadLogo(filePath: string, fileName: string, config: { url: string; key: string }) {
    try {
        console.log(`Reading file: ${filePath}`);
        const fileBytes = await Deno.readFile(filePath);
        const base64Data = encodeBase64(fileBytes);
        const dataUrl = `data:image/png;base64,${base64Data}`;

        console.log(`Uploading ${fileName}...`);

        const response = await fetch(`${config.url}/functions/v1/cloudinary-upload`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${config.key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                fileData: dataUrl,
                fileName: fileName,
                fileType: "image",
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Upload API error: ${result.error}`);
        }

        console.log(`✅ Uploaded ${fileName}: ${result.url}`);
        return { name: fileName.replace('.png', ''), url: result.url };

    } catch (error) {
        console.error(`❌ Error uploading ${fileName}:`, error);
        return null;
    }
}

async function main() {
    const config = resolveConfig();
    const args = Deno.args;
    if (args.length === 0) {
        console.error("Please provide the directory path containing images.");
        Deno.exit(1);
    }

    const dirPath = args[0];
    const uploadedLogos: Record<string, string> = {};

    for await (const entry of Deno.readDir(dirPath)) {
        if (entry.isFile && entry.name.endsWith(".png")) {
            const filePath = join(dirPath, entry.name);
            const result = await uploadLogo(filePath, entry.name, config);
            if (result) {
                uploadedLogos[result.name] = result.url;
            }
        }
    }

    // Save results
    await Deno.writeTextFile(OUTPUT_JSON_PATH, JSON.stringify(uploadedLogos, null, 2));
    console.log(`\n🎉 Saved all uploaded URLs to ${OUTPUT_JSON_PATH}`);
}

main();
