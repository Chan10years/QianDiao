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
    <figure className="overflow-hidden rounded-2xl bg-stone-100 ring-1 ring-stone-200">
      <img
        className="aspect-[4/3] w-full object-cover"
        src={objectUrl ?? "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="}
        alt="桌面材料预览"
      />
      <figcaption className="truncate px-4 py-3 text-sm text-stone-600">{file.name}</figcaption>
    </figure>
  );
}
