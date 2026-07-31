import { useQuery } from "@tanstack/react-query";
import getInstanceUsers from "@/fetchers/instance/get-instance-users";

export default function useInstanceUsers(limit = 50, offset = 0) {
  return useQuery({
    queryKey: ["instance", "users", { limit, offset }],
    queryFn: () => getInstanceUsers(limit, offset),
  });
}
