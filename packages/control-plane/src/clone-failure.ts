const CLONED_WITHOUT_TOKEN = / without GITHUB_TOKEN failed /;

export const cloneFailureDetail = (hostDetail: string, secretSetName: string): string =>
  CLONED_WITHOUT_TOKEN.test(hostDetail)
    ? `${hostDetail}. A private repository needs a Variable member GITHUB_TOKEN with read and write access in secret set ${secretSetName}; add it with tumpel config apply, then send the turn again`
    : `${hostDetail}. The persona runs on secret set ${secretSetName}`;
