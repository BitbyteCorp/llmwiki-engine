import { legacyUuidToApi } from '../common/ids.js';

export interface CommitMetadata {
  jobId: string;
  source: string;
  requester: string;
  client?: string;
}

/** A Git trailer block; callers separate it from the message with a blank line. */
export function commitTrailers(input: CommitMetadata): string {
  const fields = [
    ['Wiki-Job', legacyUuidToApi(input.jobId)],
    ['Wiki-Source', input.source],
    ['Wiki-Requester', input.requester],
    ...(input.client === undefined ? [] : [['Wiki-Client', input.client]]),
  ];
  return fields.map(([key, value]) => {
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${key} trailer value`);
    return `${key}: ${value}`;
  }).join('\n');
}
