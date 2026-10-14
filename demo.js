// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "symbol"],
  viewport: { width: 1100, height: 730 },
  async before(context) {
    const { lumine, state } = context;
    for (const p of lumine.packages.getActivePackages())
      if (p.name.startsWith("ide-") && state.serverInstall?.[p.name]?.status !== "installing")
        await lumine.packages.deactivatePackage(p.name);
  },
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("editing/signal.js");
    await lumine.project.setPaths([fixture("editing")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Extract a symbol outline directly from the Tree-sitter syntax tree.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.commands.dispatch(
            lumine.views.getView(state.editor),
            "symbol:toggle-file-symbols",
          );
        }
      },
      ready() {
        return Boolean(document.querySelector(".symbol")?.innerText.includes("SignalBuffer"));
      },
    },
  ],
  async cleanup() {},
};
