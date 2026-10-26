import { attachmentsApi } from "../../api/attachments";
import { saveBytes, type FileRef } from "../../attachments/file";
import { decryptFile } from "../../attachments/image";
import FileCard from "../messages/FileCard";

/** Файл из чата: скачать шифротекст, расшифровать на устройстве и сохранить. */
export default function ChatFile({ chatId, file, tone }: { chatId: string; file: FileRef; tone?: "own" | "other" }) {
  return (
    <FileCard
      name={file.name}
      size={file.size}
      tone={tone}
      goneText="Файл удалён — они хранятся 30 дней"
      onDownload={async () => {
        const bytes = decryptFile(await attachmentsApi.download(chatId, file.id), file.key);
        if (!bytes) throw new Error("Не удалось расшифровать файл");
        saveBytes(bytes, file.name);
      }}
    />
  );
}
