/*
 * Optional animated WebGL background ("Vibe Canvas" fluid shader, ANIMATION_4
 * from the Stitch export).
 *
 * Drop-in usage: add a canvas and this script to any page, e.g.
 *   <canvas id="shader-canvas" class="fixed inset-0 -z-10 w-full h-full"></canvas>
 *   <script src="../js/shader.js"></script>
 * The script no-ops if no #shader-canvas element is present, so it is safe to
 * include everywhere.
 */
(function () {
  const canvas = document.getElementById("shader-canvas");
  if (!canvas) return;

  function syncSize() {
    const w = canvas.clientWidth || 1280;
    const h = canvas.clientHeight || 720;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(syncSize).observe(canvas);
  }
  syncSize();

  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (!gl) return;

  const vs = `attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const fs = `precision highp float;
varying vec2 v_texCoord;
uniform float u_time;
uniform vec2 u_resolution;
void main() {
  vec2 uv = v_texCoord;
  float wave1 = sin(uv.x * 2.0 + u_time * 0.5) * 0.5 + 0.5;
  float wave2 = sin(uv.y * 3.0 - u_time * 0.3) * 0.5 + 0.5;
  float wave3 = sin((uv.x + uv.y) * 1.5 + u_time * 0.4) * 0.5 + 0.5;
  vec3 color1 = vec3(0.04, 0.07, 0.15); // deep navy
  vec3 color2 = vec3(0.19, 0.22, 0.30); // muted slate
  vec3 color3 = vec3(0.12, 0.08, 0.20); // dark violet
  vec3 finalColor = mix(color1, color2, wave1);
  finalColor = mix(finalColor, color3, wave2 * 0.5);
  finalColor = mix(finalColor, color1, wave3 * 0.3);
  float dist = distance(uv, vec2(0.5, 0.5));
  finalColor *= smoothstep(1.2, 0.3, dist);
  gl_FragColor = vec4(finalColor, 1.0);
}`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, "a_position");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(prog, "u_time");
  const uRes = gl.getUniformLocation(prog, "u_resolution");

  function render(t) {
    if (typeof ResizeObserver === "undefined") syncSize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (uTime) gl.uniform1f(uTime, t * 0.001);
    if (uRes) gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  }
  render(0);
})();
