/** What went wrong when the Workbench talked to an OpenCode server. `kind` is stable; `message` is for people. */
export type OpenCodeErrorKind =
  | 'unavailable'            // nothing answered, or the connection broke
  | 'timeout'                // the server did not answer in time
  | 'unauthorized'           // the server asked for credentials that were not given or not accepted
  | 'incompatible_version'   // the server is not the OpenCode this adapter was verified against
  | 'not_found'              // there is no such session
  | 'invalid_request'        // the server refused what was sent
  | 'refused'                // the server refused for another reason
  | 'protocol'               // the server answered something this adapter does not understand
  | 'not_installed'          // the program that starts a managed server is not there or cannot be run
  | 'directory_unavailable'  // the project directory a managed server should work in is gone or not a directory
  | 'exited'                 // a managed server ended before it could be used
  | 'pid_mismatch'           // the server that answered is not the process that was started
  | 'readonly_agent';        // the server has no agent that is proven to be read-only

export class OpenCodeError extends Error {
  constructor(readonly kind: OpenCodeErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenCodeError';
  }
}
