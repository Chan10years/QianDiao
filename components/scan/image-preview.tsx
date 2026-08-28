"use client";

import { useEffect, useState } from "react";

export function ImagePreview({ file }: { file: File }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const nextObjectUrl =
      typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
    let active = true;
    queueMicrotask(() => {
      if (active) setObjectUrl(nextObjectUrl);
    });

    return () => {
      active = false;
      if (nextObjectUrl !== null) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [file]);

  return (
    <figure className="image-preview">
      <img
        src={objectUrl ?? "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="}
        alt="桌面材料预览"
      />
      <figcaption>{file.name}</figcaption>
    </figure>
  );
}
