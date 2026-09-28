// Hash routes: #/sources, #/sources/3/history, #/endpoints/2/shape, #/data
export const route = $state({ parts: [] as string[] });

function read() {
  route.parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}
read();
addEventListener("hashchange", () => {
  read();
  scrollTo({ top: 0 });
});

export function go(path: string) {
  location.hash = "#/" + path.replace(/^\//, "");
}
