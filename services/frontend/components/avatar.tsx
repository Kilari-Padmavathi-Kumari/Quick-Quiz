"use client";

import { useEffect, useState } from "react";

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function Avatar({
  name,
  src,
  className,
  imageClassName,
  alt
}: {
  name: string;
  src?: string | null;
  className: string;
  imageClassName?: string;
  alt?: string;
}) {
  const trimmedSrc = src?.trim() ?? "";
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [trimmedSrc]);

  if (trimmedSrc.length > 0 && !imageFailed) {
    return (
      <img
        src={trimmedSrc}
        alt={alt ?? name}
        className={imageClassName ?? className}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <div className={className} aria-hidden="true">
      {getInitials(name)}
    </div>
  );
}
