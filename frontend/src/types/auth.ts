/**
 * Authenticated user details held in client-side state.
 */
export type UserInfo = {
  email: string | null;
  name: string;
  uid: string;
};

/**
 * Roles recognized by the frontend authorization flow.
 */
export type UserRole = "admin" | "reporter" | "";