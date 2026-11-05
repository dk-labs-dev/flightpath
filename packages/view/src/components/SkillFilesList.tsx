import { useId, useState } from "react";

import type { SkillFiles } from "@flightpath/flightpath/api/payloads";
import { formatSize, formatTokens } from "@flightpath/flightpath/format";

import { countLine } from "../counts.js";
import { EstimateTag } from "./EstimateTag.js";
import { ChevronIcon } from "./icons.js";

interface SkillFilesListProps {
  files: SkillFiles;
  /** The lens's class for an estimate's value and for its tag. */
  valueClass: string;
  tagClass: string;
}

/** An estimated size in the lens's own voice; an unknown one says so. */
function EstimatedSize({
  tokens,
  valueClass,
  tagClass,
}: { tokens: number | null } & Pick<
  SkillFilesListProps,
  "valueClass" | "tagClass"
>) {
  if (tokens === null) {
    return <span className="skill-files-unknown">size not known</span>;
  }
  return (
    <span className="skill-files-size">
      <span className={valueClass}>about {formatTokens(tokens)}</span>
      <EstimateTag className={tagClass} />
    </span>
  );
}

function FileDetail({
  lines,
  bytes,
}: {
  lines: number | null;
  bytes: number | null;
}) {
  const parts: string[] = [];
  if (lines !== null) parts.push(countLine(lines, "line", "lines"));
  if (bytes !== null) parts.push(formatSize(bytes));
  return <span className="skill-files-detail">{parts.join(" · ")}</span>;
}

/** The files a skill attached when it loaded, as one line that
 * opens to the files themselves: the skill's own row stays the
 * skill's text alone. */
export function SkillFilesList({
  files,
  valueClass,
  tagClass,
}: SkillFilesListProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="skill-files">
      <button
        type="button"
        className="skill-files-head"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronIcon open={open} size={14} />
        <span className="skill-files-title">
          + {countLine(files.items.length, "file", "files")} it attached
        </span>
        <EstimatedSize
          tokens={
            files.items.some((file) => file.tokens !== null)
              ? files.tokens
              : null
          }
          valueClass={valueClass}
          tagClass={tagClass}
        />
      </button>
      <ul className="skill-files-list" id={listId} hidden={!open}>
        {files.items.map((file) => (
          <li className="skill-files-file" key={file.loadId}>
            <span className="skill-files-path">{file.path}</span>
            <FileDetail lines={file.lines} bytes={file.bytes} />
            <EstimatedSize
              tokens={file.tokens}
              valueClass={valueClass}
              tagClass={tagClass}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
