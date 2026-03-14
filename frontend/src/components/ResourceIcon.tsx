/**
 * @file src/components/ResourceIcon.tsx
 * @description Inline icon for a game resource.
 *
 * ================================================================
 * HOW TO USE
 * ================================================================
 *
 *   <ResourceIcon resourceId="LIGNUM" />
 *   <ResourceIcon resourceId="SESTERTIUS" className="w-8 h-8" />
 *
 * The component maps a resource ID string to the correct image asset
 * in /public/assets/.  For RESEARCH (no image asset) it renders a
 * small styled text badge instead so callers never need a special case.
 *
 * ================================================================
 * ADDING A NEW RESOURCE
 * ================================================================
 *
 *   1. Drop the image file into frontend/public/assets/ (e.g. icon-iron.png).
 *   2. Add one line to RESOURCE_ICONS below.
 *   That's it — all ResourceIcon usages across the app pick it up automatically.
 */

import React from 'react';

// ================================================================
// ASSET MAP
// ================================================================

/**
 * Maps each resource ID to its public asset path.
 * Paths are relative to the Vite public root, so they are served at
 * exactly this URL in both dev and production builds.
 *
 * Resources without an image (RESEARCH) are intentionally absent —
 * the component falls through to the text-badge fallback below.
 */
const RESOURCE_ICONS: Readonly<Record<string, string>> = {
  SESTERTIUS: '/assets/icon-sestertius.png',
  LIGNUM:     '/assets/icon-lignum.png',
  FRUMENTUM:  '/assets/icon-frumentum.png',
  FARINA:     '/assets/icon-farina.png',
};

// ================================================================
// PROPS
// ================================================================

interface ResourceIconProps {
  /**
   * The resource identifier string (e.g. 'LIGNUM', 'SESTERTIUS').
   * Must match one of the keys defined in RESOURCE_ICONS or the
   * component renders the text-badge fallback instead.
   */
  resourceId: string;

  /**
   * Tailwind utility classes applied to the <img> (or fallback badge).
   * Defaults to a 20 × 20 px inline image with a small right margin,
   * suitable for use inside a flex row next to a resource label.
   */
  className?: string;
}

// ================================================================
// COMPONENT
// ================================================================

/**
 * Renders a small inline icon for the given resource.
 *
 * For image-backed resources (SESTERTIUS, LIGNUM, FRUMENTUM, FARINA):
 *   → <img src="/assets/icon-{resource}.png" alt="{resourceId}" … />
 *
 * For RESEARCH (no image asset):
 *   → A purple pill badge with the letter "R", styled to match icon size.
 */
const ResourceIcon: React.FC<ResourceIconProps> = ({
  resourceId,
  className = 'w-5 h-5 object-contain inline-block',
}) => {
  const src = RESOURCE_ICONS[resourceId];

  if (src) {
    return (
      <img
        src={src}
        alt={resourceId}
        // aria-hidden: the icon is purely decorative; the resource name
        // rendered beside it provides the accessible label.
        aria-hidden="true"
        className={className}
      />
    );
  }

  // ---- Fallback: RESEARCH (and any future unimaged resource) ----
  // A compact circular badge so it sits naturally alongside image icons.
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-100 border border-purple-400 text-purple-700 text-xs font-bold leading-none select-none"
    >
      R
    </span>
  );
};

export default ResourceIcon;
