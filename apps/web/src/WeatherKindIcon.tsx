import type { GroveWeatherKind } from "./weatherLocation";

/** Compact SVG marks for the four grove weather presets. */
export function WeatherKindIcon({
  kind,
  className,
  title,
}: {
  kind: GroveWeatherKind;
  className?: string;
  title?: string;
}) {
  const label = title ?? kind;
  if (kind === "sunny") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
        {title ? <title>{label}</title> : null}
        <circle cx="12" cy="12" r="4.2" fill="#f0b429" />
        <g stroke="#f0b429" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M5.2 18.8l1.7-1.7M17.1 6.9l1.7-1.7" />
        </g>
      </svg>
    );
  }
  if (kind === "cloudy") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
        {title ? <title>{label}</title> : null}
        <path
          fill="#8aa0b8"
          d="M8.2 17.5h9.1c2.1 0 3.7-1.6 3.7-3.5s-1.5-3.4-3.4-3.5c-.4-2.3-2.4-4-4.8-4-1.7 0-3.2.9-4.1 2.2-.5-.3-1.1-.4-1.7-.4-1.9 0-3.4 1.5-3.4 3.3 0 .3 0 .6.1.9-1.3.4-2.2 1.6-2.2 3 0 1.7 1.4 3 3.1 3z"
        />
        <path fill="#c5d0dc" d="M7.5 15.2c-.2 0-.4 0-.6.1C5.6 15.5 4.5 16.6 4.5 18c0 .2 0 .3.1.5H8c-1.1-.4-1.8-1.3-1.8-2.4 0-.4.1-.7.3-.9z" />
      </svg>
    );
  }
  if (kind === "rain") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
        {title ? <title>{label}</title> : null}
        <path
          fill="#7a90a8"
          d="M7.8 13.2h8.4c1.9 0 3.4-1.5 3.4-3.2S18.2 6.8 16.4 6.7c-.4-2.1-2.2-3.6-4.4-3.6-1.5 0-2.9.8-3.7 2-.5-.2-1-.4-1.5-.4-1.7 0-3.1 1.3-3.1 3 0 .2 0 .5.1.8C2.6 8.9 1.8 10 1.8 11.3c0 1.5 1.3 2.8 2.9 2.8h.2z"
        />
        <g stroke="#4a7ab8" strokeWidth="1.6" strokeLinecap="round">
          <path d="M8 15.2v3.2M12 16v3.4M16 15.2v3.2" />
        </g>
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{label}</title> : null}
      <path
        fill="#9aadc0"
        d="M7.8 12.5h8.4c1.9 0 3.4-1.5 3.4-3.2S18.2 6.1 16.4 6c-.4-2.1-2.2-3.6-4.4-3.6-1.5 0-2.9.8-3.7 2-.5-.2-1-.4-1.5-.4-1.7 0-3.1 1.3-3.1 3 0 .2 0 .5.1.8C2.6 8.2 1.8 9.3 1.8 10.6c0 1.5 1.3 2.8 2.9 2.8h.2z"
      />
      <g fill="#d8e6f2">
        <path d="M8.2 14.8l.9 1.5-.9 1.5-.9-1.5zM12 15.6l.9 1.5-.9 1.5-.9-1.5zM15.8 14.8l.9 1.5-.9 1.5-.9-1.5z" />
      </g>
    </svg>
  );
}
