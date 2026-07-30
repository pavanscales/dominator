const std = @import("std");

pub fn build(b: *std.Build) void {
    // ── WASM target with SIMD128 + bulk-memory + all speed features ──
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .simd128,
            .bulk_memory,
            .nontrapping_fptoint,
            .sign_ext,
            .reference_types,
            .atomics,
            .mutable_globals,
        }),
    });

    const optimize = b.standardOptimizeOption(.{});

    // ── Core WASM Module ──────────────────────────────────────────────────────
    const core_exe = b.addExecutable(.{
        .name = "dominator_core",
        .root_source_file = b.path("dominator_core.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });
    core_exe.entry = .disabled;
    core_exe.import_memory = true;
    core_exe.initial_memory = 262144; // 256 pages * 64KB = 16MB
    core_exe.max_memory = 262144;
    core_exe.shared_memory = true;
    core_exe.linkLibC(); // Enables LLVM optimizations for memcpy/memset

    const install_core = b.addInstallArtifact(core_exe, .{
        .dest_dir = .{ .override = .{ .custom = "../dist/zig" } },
    });
    b.getInstallStep().dependOn(&install_core.step);

    // ── Physics WASM Module ───────────────────────────────────────────────────
    const physics_exe = b.addExecutable(.{
        .name = "physics",
        .root_source_file = b.path("physics.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });
    physics_exe.entry = .disabled;
    physics_exe.import_memory = true;
    physics_exe.initial_memory = 32768; // 512 pages * 64KB = 32MB
    physics_exe.max_memory = 32768;
    physics_exe.shared_memory = true; // SharedArrayBuffer for zero-copy main thread
    physics_exe.linkLibC();

    const install_physics = b.addInstallArtifact(physics_exe, .{
        .dest_dir = .{ .override = .{ .custom = "../dist/zig" } },
    });
    b.getInstallStep().dependOn(&install_physics.step);

    // ── Tests ─────────────────────────────────────────────────────────────────
    const core_tests = b.addTest(.{
        .root_source_file = b.path("dominator_core.zig"),
        .optimize = optimize,
    });
    const run_core_tests = b.addRunArtifact(core_tests);

    const physics_tests = b.addTest(.{
        .root_source_file = b.path("physics.zig"),
        .optimize = optimize,
    });
    const run_physics_tests = b.addRunArtifact(physics_tests);

    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_core_tests.step);
    test_step.dependOn(&run_physics_tests.step);
}
