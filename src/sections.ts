/**
 * Pi-vcc section types.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/sections.ts)
 * Unmodified.
 */

export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  briefTranscript: string;
}
