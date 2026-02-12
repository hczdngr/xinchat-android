export default function access(
  initialState: { currentUser?: API.CurrentUser } | undefined,
) {
  const currentUser = initialState?.currentUser;
  return {
    canAdmin: currentUser?.access === 'admin',
  };
}
