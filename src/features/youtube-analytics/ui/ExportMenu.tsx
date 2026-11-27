import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  buildYouTubeAnalyticsCsv,
  buildYouTubeAnalyticsCsvFilename,
  type YouTubeAnalyticsCsvExportInput,
} from "../domain/exportCsv";

/**
 * Export of the report already held in memory.
 *
 * Both actions are local to the browser: the CSV is built from the loaded
 * report, handed to the browser as an object URL and revoked again right
 * after the click. Nothing is requested from the server and nothing is written
 * to browser storage, so the export cannot leak a channel's numbers.
 */
export function ExportMenu({ input, disabled = false }: {
  input: YouTubeAnalyticsCsvExportInput;
  disabled?: boolean;
}) {
  const { t } = useTranslation("analytics");

  const downloadCsv = () => {
    const csv = buildYouTubeAnalyticsCsv(input);
    const filename = buildYouTubeAnalyticsCsvFilename(input.channelTitle, input.window);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={downloadCsv}>
        {t("youtube.export.csv", "Download CSV")}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => window.print()}>
        {t("youtube.export.print", "Print / save as PDF")}
      </Button>
    </div>
  );
}
