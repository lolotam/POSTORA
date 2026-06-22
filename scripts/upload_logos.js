
import fs from 'fs';
import path from 'path';

function resolveConfig() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://api.postora.cloud";
    const key = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim();

    if (!key) {
        console.error("Missing required env var SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY). Copy .env.example to .env and set it.");
        process.exit(1);
    }

    return { url, key };
}

const OUTPUT_JSON_PATH = "logo_urls.json";

async function uploadLogo(filePath, fileName, config) {
    try {
        console.log(`Reading file: ${filePath}`);
        const fileBytes = fs.readFileSync(filePath);
        const base64Data = fileBytes.toString('base64');
        const dataUrl = `data:image/png;base64,${base64Data}`;

        console.log(`Uploading ${fileName}...`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

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
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Upload API error: ${result.error}`);
        }

        console.log(`✅ Uploaded ${fileName}: ${result.url}`);
        // clean name by removing timestamp suffix if present
        const cleanName = fileName.replace(/_logo_\d+\.png$/, '').replace('.png', '');
        return { name: cleanName, url: result.url };

    } catch (error) {
        console.error(`❌ Error uploading ${fileName}:`, error);
        return null;
    }
}

async function main() {
    const config = resolveConfig();
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Please provide the directory path containing images.");
        process.exit(1);
    }

    const dirPath = args[0];
    const uploadedLogos = {};

    const files = fs.readdirSync(dirPath);

    for (const file of files) {
        if (file.endsWith(".png") && file.includes("_logo_")) {
            const filePath = path.join(dirPath, file);
            const result = await uploadLogo(filePath, file, config);
            if (result) {
                uploadedLogos[result.name] = result.url;
            }
        }
    }

    // Save results
    fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(uploadedLogos, null, 2));
    console.log(`\n🎉 Saved all uploaded URLs to ${OUTPUT_JSON_PATH}`);
}

main();
