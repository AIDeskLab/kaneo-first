export type InstanceWorkspaceMembership = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

export type InstanceUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  locale: string | null;
  role: string | null;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
  workspaces: InstanceWorkspaceMembership[];
};

export type InstanceUsersResponse = {
  users: InstanceUser[];
  total: number;
  limit: number;
  offset: number;
};

export type InstanceWorkspace = {
  id: string;
  name: string;
  slug: string;
  roles: { name: string; isBuiltIn: boolean }[];
};
